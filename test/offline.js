// offline.js: W1's gate. Asserts that sw.js actually makes the app work with no
// network, and that its precache manifest still matches the tree.
//
// WHY THIS FILE EXISTS AT ALL. README.md used to claim the web app "works
// offline outright", and WEB-COMPLETION-PLAN.md §W1 recorded that it did not:
// every runtime asset was vendored, so no CDN was needed AT SCAN TIME, but the
// page itself still came over the network like any website. sw.js closes that.
// A service worker is exactly the kind of component that reports success while
// doing nothing useful - registration resolves, the cache looks plausible, and
// the first person to find out it does not work offline is a user on a train.
//
// ---------------------------------------------------------------------------
// HOW "THE NETWORK IS OFF" IS ENFORCED HERE, AND WHY NOT route interception.
//
// Three mechanisms, layered, because the weak one is the one that would make
// this gate pass for the wrong reason:
//
//   1. context.setOffline(true). Playwright's context-level network emulation,
//      enforced BELOW the service worker - so the worker's own fetch() calls
//      fail too, which is the whole point.
//
//   2. A SERVER-SIDE WITNESS. The static server counts every request it serves
//      and this gate records the count before and after each offline step. If
//      anything at all reached the server while the page was supposed to be
//      offline, the count moves and the gate fails, naming the URLs. This is
//      what makes step 1 self-checking rather than trusted: an emulation gap
//      cannot hide, because the proof is on the other side of the socket.
//
//   3. THE SERVER IS THEN CLOSED OUTRIGHT - close() plus closeAllConnections()
//      to destroy keep-alives - and the Library is reloaded once more. At that
//      point there is no listening socket to reach, so no emulation is being
//      trusted at all.
//
// page.route("**", r => r.abort()) is deliberately NOT the mechanism. Route
// interception operates on the PAGE's request path, and requests issued by a
// service worker are not reliably subject to it - so the exact component under
// test could have gone on fetching from the real server while the gate reported
// a clean offline pass. A test whose failure mode is "silently proves nothing"
// is worse here than no test.
//
// ---------------------------------------------------------------------------
// THE MANIFEST CHECK, which is the half that will earn its keep later. sw.js
// cannot glob a directory, so its SHELL_ASSETS list is the one place in the repo
// that restates what js/ contains - and therefore the thing that rots the next
// time a module is renamed. Checked in BOTH directions against `ls js/*.js`:
// a module on disk and missing from the manifest is a file that will not be
// there offline, and a manifest entry with no file behind it is a precache that
// fails on install. Either one fails here rather than in a user's offline tab.
//
// The buckets are asserted as buckets, too: the 6.7 MB recognition payload must
// be ABSENT from the cache before the first scan (precaching 11 MB of
// vendor/tesseract at install time would make first load hostile, which is the
// thing §W1 names) and PRESENT after it.
//
// Usage: node test/offline.js

import { launchBrowser, listenOnEphemeralPort, contentTypeFor, takeConsoleErrors } from "./browser.js";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The server-side witness. Every served path is recorded WITH THE PHASE it
// arrived in, so the output says not just that something reached the server but
// during which step - which is what turned one confusing failure into a
// diagnosis (see THE ONE EXCEPTION, below).
const served = [];
let phase = "setup";

// Two switches the later steps flip. `deploy` stands in for a new build landing
// on Pages; `FAIL_PUT_PRELUDE` is served ahead of the REAL sw.js when a worker is
// registered from /sw.js?failput=1, so the shipped strategy functions run against
// a Cache API whose put always rejects. Stubbing it this way - rather than adding
// a test-only flag to sw.js - means what runs in CI is the production code path.
let deploy = 1;

const FAIL_PUT_PRELUDE = `
// Injected by test/offline.js. Every cache.put rejects, exactly as a full disk
// does. open/match/keys/delete are left working, because the defects under test
// are specifically about a failing WRITE.
(() => {
  const realOpen = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await realOpen(name);
    return new Proxy(cache, {
      get(target, prop) {
        if (prop === "put") {
          return () => Promise.reject(new DOMException("Quota exceeded (test stub)", "QuotaExceededError"));
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
})();
`;

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  const failPut = req.url.includes("failput=1");
  served.push({ path, phase });
  // The directory URL resolves to index.html for the CONTENT TYPE as well as
  // the bytes, and that is not a detail: this is the one gate that navigates to
  // the bare directory URL a bookmark opens, so it is the one that found the
  // whole suite serving "/" as application/octet-stream and made Chromium
  // DOWNLOAD the app instead of rendering it. The full account, and the
  // resolver every gate now shares, are in test/browser.js's contentTypeFor -
  // moved there because the defect was never specific to this file.
  const filePath = path.endsWith("/") ? `${path}index.html` : path;
  try {
    let body = await readFile(join(ROOT, filePath));
    if (deploy === 2) {
      // A new build: one marker in the navigation document, one in a module, so
      // the two halves of the shell can be told apart from their cached copies.
      if (filePath.endsWith("index.html")) {
        body = Buffer.from(String(body).replace("<title>TextScanner</title>", "<title>TextScanner DEPLOY-2</title>"));
      }
      if (filePath.endsWith("js/state.js")) {
        body = Buffer.from(String(body).replace('APP_VERSION = "1.0.0"', 'APP_VERSION = "9.9.9"'));
      }
    }
    if (failPut && filePath.endsWith("sw.js")) {
      body = Buffer.from(FAIL_PUT_PRELUDE + String(body));
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("nf");
  }
});
const PORT = await listenOnEphemeralPort(server);
const origin = `http://localhost:${PORT}`;

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
};

// Snapshots the witness so a step can assert nothing was served during it.
let witnessMark = 0;
const markWitness = (name) => {
  witnessMark = served.length;
  phase = name;
};
const servedSinceMark = () => served.slice(witnessMark);

// THE ONE EXCEPTION, and it is a measured finding rather than a convenience.
//
// /sw.js still reaches the server during the offline steps, WITH
// context.setOffline(true) active. It is not this gate registering again (the
// offline navigations carry no ?sw, so js/serviceWorkerRegistration.js does not
// call register()) and nothing else in the repo fetches that path. It is the
// browser's own service-worker script UPDATE CHECK, which the spec has a
// navigation to an in-scope URL trigger - and which Chromium issues outside
// Playwright's context-level offline emulation. It arrives a beat after the
// navigation resolves, which is why it first showed up in the window for the
// step AFTER the one that caused it.
//
// Three reasons it is allowed here rather than being called a broken offline
// claim: it is the worker SCRIPT, not an app resource, so nothing the app
// renders or recognizes came from the network; with a genuinely absent network
// it simply fails and the installed worker keeps serving, which is precisely
// what STEP 9 demonstrates with the socket closed; and it is the very mechanism
// that keeps this app updatable, so suppressing it would be undesirable even if
// it were possible.
//
// It is allowed as ONE EXACT PATH, never as a category: any other request
// reaching the server during an offline step still fails the run.
const SW_UPDATE_CHECK = "/sw.js";
const appAssetsSince = () => servedSinceMark().filter((entry) => entry.path !== SW_UPDATE_CHECK);
const describe = (entries) => entries.map((entry) => `${entry.path} (during ${entry.phase})`).join(", ");

const browser = await launchBrowser({ headless: true });

// ---------------------------------------------------------------------------
// STEP 1: THE ESCAPE HATCH. A plain load must register nothing.
//
// This is the assertion that protects the other 32 gates. They all serve the app
// over http://localhost:<ephemeral> with no query string, and
// js/serviceWorkerRegistration.js registers only over https: or on an explicit
// ?sw opt-in - so none of them can acquire a worker that starts answering their
// requests from a cache. §W1 leaves the choice of hatch open; this is the
// evidence for the one that was taken, and it belongs in CI rather than in a
// commit message, because the hatch is a condition someone could widen later
// without realising what it was holding back.
console.log("\nThe escape hatch: a plain load registers nothing");

{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => failures.push(`pageerror (plain load): ${e.message}`));

  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 15000 });

  const state = await page.evaluate(async () => ({
    supported: "serviceWorker" in navigator,
    controller: !!navigator.serviceWorker?.controller,
    registrations: (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0,
    cacheNames: await caches.keys(),
  }));

  check("the browser under test does support service workers", state.supported, "otherwise the rest of this gate proves nothing");
  check("a plain http:// load leaves the page uncontrolled", state.controller === false);
  check("a plain http:// load creates no registration", state.registrations === 0, `found ${state.registrations}`);
  check("a plain http:// load creates no cache", state.cacheNames.length === 0, state.cacheNames.join(", "));

  await context.close();
}

// ---------------------------------------------------------------------------
// STEP 2: register on the opt-in, and check what landed in each bucket.
console.log("\nRegistration on ?sw, and the two cache buckets");

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

await page.goto(`${origin}/index.html?sw=1`);
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
check("?sw=1 registers a worker that takes control of the page", true);

// The worker calls skipWaiting() only after its precache completes, so a
// non-null controller means install finished - no separate wait needed.
const manifest = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      navigator.serviceWorker.controller.postMessage("sw:manifest", [channel.port2]);
    })
);

const cacheState = async () =>
  page.evaluate(async ({ shellCache, vendorCache }) => {
    const read = async (name) => {
      if (!(await caches.has(name))) return null;
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => request.url);
    };
    return { shell: await read(shellCache), vendor: await read(vendorCache) };
  }, manifest);

const beforeScan = await cacheState();

const toPath = (url) => url.slice(`${origin}/`.length);
const shellPaths = (beforeScan.shell || []).map(toPath);

check("the shell cache exists after install", Array.isArray(beforeScan.shell), "no shell cache was created");
check(
  "every asset the worker declares is actually in the shell cache",
  manifest.shell.every((url) => (beforeScan.shell || []).includes(url)),
  `missing: ${manifest.shell.filter((url) => !(beforeScan.shell || []).includes(url)).map(toPath).join(", ")}`
);

// The bucket split, asserted as a property rather than described in a comment:
// the 6.7 MB recognition payload must NOT be part of a first load.
const heavyInShell = shellPaths.filter(
  (path) => path.startsWith("vendor/tesseract/core/") || path.startsWith("vendor/tesseract/tessdata/")
);
check(
  "the wasm cores and tessdata are NOT precached at install",
  heavyInShell.length === 0,
  `first load would have paid for: ${heavyInShell.join(", ")}`
);
check(
  "the vendor cache is empty before the first scan",
  beforeScan.vendor === null || beforeScan.vendor.length === 0,
  `already held: ${(beforeScan.vendor || []).map(toPath).join(", ")}`
);
// tesseract.min.js is the exception in that tree and has to be: index.html
// loads it in a blocking classic <script>, so the page cannot boot without it.
check(
  "tesseract.min.js IS in the shell, because index.html blocks on it",
  shellPaths.includes("vendor/tesseract/tesseract.min.js")
);

// ---------------------------------------------------------------------------
// STEP 3: THE MANIFEST vs THE TREE, both directions.
console.log("\nThe precache manifest against the tree");

const jsOnDisk = (await readdir(join(ROOT, "js"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => `js/${entry.name}`)
  .sort();

const declared = manifest.shell.map(toPath);
const declaredJs = declared.filter((path) => path.startsWith("js/")).sort();

const missingFromManifest = jsOnDisk.filter((path) => !declaredJs.includes(path));
const missingFromDisk = declaredJs.filter((path) => !jsOnDisk.includes(path));

check(
  "every js/*.js on disk is in sw.js's precache manifest",
  missingFromManifest.length === 0,
  `sw.js never caches, so offline will 404 on: ${missingFromManifest.join(", ")} - add them to SHELL_ASSETS in sw.js`
);
check(
  "every js/ entry in sw.js's manifest exists on disk",
  missingFromDisk.length === 0,
  `sw.js precaches files that are not there, which fails install: ${missingFromDisk.join(", ")} - remove them from SHELL_ASSETS in sw.js`
);
check(
  "the manifest lists exactly as many modules as the tree holds",
  declaredJs.length === jsOnDisk.length,
  `manifest ${declaredJs.length}, disk ${jsOnDisk.length}`
);

// The non-js half of the shell, each checked to exist rather than taken on
// trust - a renamed icon is the same class of bug as a renamed module.
const NON_JS_SHELL = [
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "vendor/tesseract/tesseract.min.js",
  "vendor/fonts/roboto-condensed/RobotoCondensed-Regular.ttf",
];
for (const path of NON_JS_SHELL) {
  const inManifest = declared.includes(path);
  let onDisk = true;
  try {
    await readFile(join(ROOT, path));
  } catch {
    onDisk = false;
  }
  check(`shell asset ${path} is both declared and present`, inManifest && onDisk, `manifest:${inManifest} disk:${onDisk}`);
}
// "./" is cached as well as index.html because a reload of the deployed URL
// requests the directory, not the filename.
check("the bare directory URL is cached too", declared.includes(""), "a reload of the deployed URL asks for ./, not index.html");

// ---------------------------------------------------------------------------
// STEP 4: a real scan, online, to fill the lazy bucket.
console.log("\nThe first scan fills the recognition bucket");

await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic2.jpeg"));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });

const onlineScan = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  return { words: state.ocrWords?.length ?? 0, text: (document.getElementById("result-text")?.value || "").trim() };
});
check("the online scan recognized words", onlineScan.words > 0, `${onlineScan.words} words`);
check("the online scan produced text", onlineScan.text.length > 0, `${onlineScan.text.length} chars`);

const afterScan = await cacheState();
const vendorPaths = (afterScan.vendor || []).map(toPath);
const cores = vendorPaths.filter((path) => path.startsWith("vendor/tesseract/core/"));

check("the scan cached the Tesseract worker", vendorPaths.includes("vendor/tesseract/worker.min.js"), vendorPaths.join(", "));
check("the scan cached the language data", vendorPaths.includes("vendor/tesseract/tessdata/eng.traineddata.gz"), vendorPaths.join(", "));
check("the scan cached exactly one wasm core, not both", cores.length === 1, `cached ${cores.length}: ${cores.join(", ")}`);

// A document in the library, so the offline reload has something real to render
// rather than an empty state that would look the same if nothing loaded.
const seeded = await page.evaluate(async () => {
  const docs = await import("/js/documents.js");
  const doc = await docs.createDocument({ type: docs.DOC_TYPES.NOTE, title: "Offline canary note" });
  return doc.title;
});
check("a document was seeded for the offline render to find", seeded === "Offline canary note");

const consoleBeforeOffline = takeConsoleErrors(page);
check("nothing logged a console error while online", consoleBeforeOffline.length === 0, consoleBeforeOffline.join(" | "));

// ---------------------------------------------------------------------------
// STEP 5: OFFLINE. A full reload must render the Library.
console.log("\nOffline: a full reload renders the Library");

await context.setOffline(true);
markWitness("the offline Library load");

// A COLD NAVIGATION TO THE BARE DEPLOYED URL, not page.reload(), and the
// difference is not cosmetic. Two things made reload() the wrong instrument,
// both found by running it:
//
//   - This app routes with pushState (js/views.js). The online scan above left
//     the URL on the scan route, so reloading it correctly restored the SCAN
//     view - and an assertion that the Library renders then failed against an
//     app that was behaving properly. What a user does offline is reopen the
//     app, not re-execute their last route.
//   - reload() reuses the current URL, which still carried ?sw=1, so
//     js/serviceWorkerRegistration.js called register() again - and a repeat
//     register() on a live scope triggers the browser's soft update check,
//     which fetched /sw.js. The server-side witness caught it. That request was
//     this gate's own doing rather than the app reaching for the network, but a
//     witness that has to be told to ignore things stops being a witness.
//
// So: the bare directory URL, which is what a bookmark and an installed
// home-screen icon actually open, and which exercises the "./" cache entry.
await page.goto(`${origin}/`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 30000 });

const offlineRender = await page.evaluate(() => {
  const view = document.getElementById("view-library");
  return {
    activeView: document.body.dataset.activeView,
    libraryVisible: !!view && !view.classList.contains("hidden"),
    // Rendered BY js/library.js, not present in the markup - so this is the
    // assertion that the modules actually executed rather than the HTML merely
    // having been served.
    sidebarRendered: (document.getElementById("library-sidebar")?.children.length ?? 0) > 0,
    listHtml: document.getElementById("library-list")?.textContent || "",
    countText: document.getElementById("library-count")?.textContent || "",
    controller: !!navigator.serviceWorker.controller,
  };
});

check("the page is still controlled by the worker after an offline reload", offlineRender.controller);
check("the Library is the active view", offlineRender.activeView === "library", offlineRender.activeView);
check("the Library section is visible", offlineRender.libraryVisible);
check("js/library.js ran and rendered the sidebar", offlineRender.sidebarRendered, "the markup is always in the DOM; this proves the module executed");
check("the seeded document is listed", offlineRender.listHtml.includes("Offline canary note"), offlineRender.listHtml.slice(0, 200));
check("the library count rendered", offlineRender.countText.trim().length > 0, offlineRender.countText);

const servedDuringLoad = appAssetsSince();
check(
  "the offline load fetched no app asset from the server",
  servedDuringLoad.length === 0,
  `the server served ${servedDuringLoad.length} request(s), so the page was not offline: ${describe(servedDuringLoad)}`
);

// ---------------------------------------------------------------------------
// STEP 6: OFFLINE. A scan of a local image completes end to end.
console.log("\nOffline: scanning a local image completes end to end");

markWitness("the offline scan");

await page.setInputFiles("#file-input", join(ROOT, "test/images/complexPic2.jpeg"));
await page.click("#scan-btn");
await page.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });

const offlineScan = await page.evaluate(async () => {
  const { state } = await import("/js/state.js");
  return {
    words: state.ocrWords?.length ?? 0,
    text: (document.getElementById("result-text")?.value || "").trim(),
  };
});

check("the offline scan recognized words", offlineScan.words > 0, `${offlineScan.words} words`);
check("the offline scan produced text", offlineScan.text.length > 0);
// The strong form: not merely "something came back", but the SAME thing. This
// image through this core is deterministic run to run (test/TUNING-2.md §1
// measured 0.00pts across two bit-identical runs), so a cached wasm core or
// traineddata that came back subtly wrong - a truncated response stored by the
// worker, a partial body cached as though complete - shows up as a diff here
// rather than as quietly worse recognition for offline users. Accuracy itself
// stays other gates' business; this is byte-integrity of the cached payload.
check(
  "the offline scan reproduces the online result exactly",
  offlineScan.text === onlineScan.text && offlineScan.words === onlineScan.words,
  `online ${onlineScan.words} words / ${onlineScan.text.length} chars, offline ${offlineScan.words} words / ${offlineScan.text.length} chars`
);

const servedDuringScan = appAssetsSince();
check(
  "the offline scan fetched no app asset from the server",
  servedDuringScan.length === 0,
  `the server served ${servedDuringScan.length} request(s), so recognition was not offline: ${describe(servedDuringScan)}`
);
// Stated as its own assertion rather than filtered away in silence: the whole
// point of the witness is that the exception list is visible and exactly one
// path long. If Chromium ever stops issuing the update check through an offline
// context, this goes red and the comment above it gets deleted.
const updateChecks = served.filter((entry) => entry.path === SW_UPDATE_CHECK && entry.phase.startsWith("the offline"));
check(
  "the only thing that crossed an offline context was the sw.js update check",
  updateChecks.length > 0,
  "no /sw.js request was seen offline - if Chromium changed, simplify the SW_UPDATE_CHECK exception away"
);

const offlineConsole = takeConsoleErrors(page);
check("nothing logged a console error while offline", offlineConsole.length === 0, offlineConsole.join(" | "));

// ---------------------------------------------------------------------------
// STEP 7: A CACHE WRITE THAT FAILS MUST NOT CHANGE WHAT THE PAGE RECEIVES.
//
// Two shipped defects, both from an unguarded `await cache.put`, both firing on a
// full disk - which for an app that fills IndexedDB with scanned documents is a
// state real users reach, not a thought experiment:
//
//   - networkFirst had the put INSIDE its try. A rejecting put fell into the
//     catch, which served the STALE cached copy while the network was healthy and
//     had just returned a good response - the precise version skew sw.js's header
//     says the whole design exists to prevent.
//   - cacheFirst had the same put throw straight out, so respondWith rejected and
//     the browser reported a network error for eng.traineddata.gz. A full disk
//     broke scanning outright even though the file had downloaded fine.
//
// The stub makes every put reject with a QuotaExceededError while leaving reads
// working, and these assertions - not the wrappers in sw.js - are what hold the
// invariant. Both need a POPULATED cache plus a failing put, so the step installs
// the normal worker first, lets it cache deploy 1, changes what the server
// returns, and only then swaps in the worker whose puts fail. With the defect, the
// stale deploy-1 copy is what comes back.
console.log("\nA failing cache.put must not change what the page receives");

{
  markWitness("the hostile-cache step");
  const hostileContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const hostilePage = await hostileContext.newPage();
  hostilePage.on("pageerror", (e) => failures.push(`pageerror (hostile cache): ${e.message}`));

  // 1. The normal worker, caching the CURRENT build.
  await hostilePage.goto(`${origin}/index.html?sw=1`);
  await hostilePage.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  const cachedTitle = await hostilePage.title();
  check("the hostile-cache step starts from a populated cache", cachedTitle === "TextScanner", cachedTitle);

  // 2. A new build lands.
  deploy = 2;

  // 3. Swap in the worker whose puts all reject. Registered explicitly with a
  //    query so it is a distinct script URL: js/serviceWorkerRegistration.js only
  //    ever registers the plain path, and this is testing sw.js's strategies
  //    rather than the registration module. keyFor() strips the query, and BASE
  //    resolves from the directory, so neither is affected by it.
  await hostilePage.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?failput=1", { scope: "./" });
    await navigator.serviceWorker.ready;
  });
  await hostilePage.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.includes("failput=1"), null, {
    timeout: 30000,
  });
  check("the put-failing worker is in control", true);

  // 4. networkFirst: the network is FINE and has fresh bytes. The put fails.
  await hostilePage.goto(`${origin}/index.html`, { waitUntil: "load", timeout: 30000 });
  await hostilePage.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 30000 });

  const underFailingPut = await hostilePage.evaluate(() => ({
    title: document.title,
    footer: document.getElementById("footer-version")?.textContent || "(none)",
    activeView: document.body.dataset.activeView || "(none)",
  }));

  check(
    "networkFirst serves the FRESH document when the cache write fails",
    underFailingPut.title === "TextScanner DEPLOY-2",
    `got ${JSON.stringify(underFailingPut.title)} - a stale cached copy means the failed put was ` +
      `mistaken for a failed network, which is the version skew sw.js exists to prevent`
  );
  check(
    "networkFirst serves the FRESH module when the cache write fails",
    underFailingPut.footer === "9.9.9",
    `footer-version reads ${JSON.stringify(underFailingPut.footer)}, so js/state.js came from the stale cache`
  );
  check("the app still boots with every cache write failing", underFailingPut.activeView === "library", underFailingPut.activeView);

  // 5. cacheFirst: the recognition payload downloads fine and cannot be stored.
  //    Scanning must still work. With the defect this is where it broke: the put
  //    threw out of cacheFirst, respondWith rejected, and the browser reported a
  //    network error for eng.traineddata.gz.
  await hostilePage.setInputFiles("#file-input", join(ROOT, "test/images/complexPic2.jpeg"));
  await hostilePage.click("#scan-btn");
  let scanCompleted = true;
  try {
    await hostilePage.waitForSelector("#result-section:not(.hidden)", { timeout: 180000 });
  } catch {
    scanCompleted = false;
  }
  const hostileScan = scanCompleted
    ? await hostilePage.evaluate(async () => {
        const { state } = await import("/js/state.js");
        return state.ocrWords?.length ?? 0;
      })
    : 0;

  check(
    "cacheFirst still completes a scan when the payload cannot be cached",
    scanCompleted && hostileScan > 0,
    scanCompleted
      ? `scan finished but recognized ${hostileScan} words`
      : "the scan never produced a result - a failing cache write broke recognition outright, " +
        "which is what a full disk did before the fix"
  );

  // A quota failure is a warning, not an error, and must stay that way: the page
  // is working, so logging console.error would make every gate in this suite red
  // on a full disk.
  const hostileConsole = takeConsoleErrors(hostilePage);
  check(
    "a failing cache write logs no console ERROR",
    hostileConsole.length === 0,
    hostileConsole.join(" | ")
  );

  await hostileContext.close();
  deploy = 1;
}

// ---------------------------------------------------------------------------
// STEP 8: LIE-FI. A connection that hangs instead of failing.
//
// network-first with no timeout handled "offline" - fetch rejects, the catch runs
// - and MISHANDLED lie-fi: a captive portal accepts the request and never answers,
// so fetch stayed pending, never rejected, and the fallback never ran. Measured at
// 1bbc46e with the route handler below: hard offline rendered the Library, and the
// navigation hung for the full 40s of this step's patience with a perfectly good
// cached copy sitting unused.
//
// sw.js now races every network-first request against NETWORK_FIRST_TIMEOUT_MS
// (8s). Deliberately not applied to cacheFirst - that path pulls 6.7 MB with no
// cached fallback to race toward, and a timeout there would turn slow-but-working
// downloads into failed scans.
//
// WHAT THIS ASSERTS, AND WHY IT IS THE COMMIT RATHER THAN THE LOAD. The defect was
// "the document never arrives". So the tight bound is on `waitUntil: "commit"` -
// the navigation's own bytes - which is exactly what the race fixes, and which
// measured 8019ms once the fix was in.
//
// The full boot is asserted too, but with a deliberately loose budget, because on
// THIS server it is dominated by something that is not the app: the test server is
// HTTP/1.1, so ~54 module requests queue about six at a time and each burns the
// full 8s timeout - measured at 40091ms after commit. The live deployment is
// HTTP/2 (`curl -o /dev/null -w %{http_version}` against
// /TextScanner/js/main.js returns 2), so those requests multiplex on one
// connection and time out concurrently, putting real-world lie-fi recovery at
// roughly one timeout rather than ten. Pinning the loose number here would be
// pinning Chromium's per-host connection limit, not this app's behaviour.
console.log("\nLie-fi: a hanging connection falls back instead of hanging");

{
  markWitness("the lie-fi step");
  const lieFiContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const lieFiPage = await lieFiContext.newPage();
  lieFiPage.on("pageerror", (e) => failures.push(`pageerror (lie-fi): ${e.message}`));

  await lieFiPage.goto(`${origin}/index.html?sw=1`);
  await lieFiPage.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });

  // A NEW BUILD LANDS BEFORE THE HANG IS ARMED, and this is what stops the step
  // passing for the wrong reason. Route interception is not reliably applied to
  // requests a service worker issues (the same property that made it the wrong
  // tool for the offline steps - see the header). If it failed to reach the
  // worker's fetch here, the worker would quietly reach the real server, the page
  // would render, and the assertion would go green while proving nothing. So the
  // server starts returning DEPLOY-2 first: the cached copy still says
  // "TextScanner", so the title tells us WHICH side answered.
  deploy = 2;

  // Every request is accepted and never answered. Not an abort - an abort would
  // reject, and the plain catch path already handled that case.
  await lieFiContext.route("**/*", () => {});

  let committed = false;
  let commitMs = 0;
  let servedTitle = "(navigation never committed)";
  const startedAt = Date.now();
  try {
    await lieFiPage.goto(`${origin}/`, { waitUntil: "commit", timeout: 40000 });
    commitMs = Date.now() - startedAt;
    servedTitle = await lieFiPage.title();
    committed = true;
  } catch (error) {
    commitMs = Date.now() - startedAt;
    servedTitle = `(HUNG: ${error.message.split("\n")[0]})`;
  }

  check("a hanging network serves the document from cache instead of hanging", committed, `after ${commitMs}ms: ${servedTitle}`);
  // Generous upper bound rather than a tight one: this pins "one timeout, not
  // forever". Below 8s would mean the race fired early; anywhere near 40s would
  // mean it did not fire at all.
  check(
    "it falls back within roughly one timeout, not after an unbounded wait",
    committed && commitMs >= 7000 && commitMs < 20000,
    `committed in ${commitMs}ms; NETWORK_FIRST_TIMEOUT_MS is 8000`
  );
  check(
    "and the fallback came from the CACHE, not from a network the hang failed to block",
    servedTitle === "TextScanner",
    `title is ${JSON.stringify(servedTitle)}; DEPLOY-2 would mean route interception never reached ` +
      `the worker's fetch, so this step would have been proving nothing`
  );

  // The app does come all the way up; see the note above on why the number is not
  // asserted tightly.
  let bootMs = 0;
  let booted = false;
  const bootStarted = Date.now();
  try {
    await lieFiPage.waitForFunction(() => document.body?.dataset?.activeView, null, { timeout: 180000 });
    bootMs = Date.now() - bootStarted;
    booted = (await lieFiPage.evaluate(() => document.body.dataset.activeView)) === "library";
  } catch {
    bootMs = Date.now() - bootStarted;
  }
  check("and the app boots all the way to the Library", booted, `${bootMs}ms after commit`);
  console.log(`       (commit ${commitMs}ms, boot +${bootMs}ms - the boot figure is this HTTP/1.1 server's`);
  console.log(`        six-connection limit against 50 modules, not the app; production is HTTP/2)`);

  await lieFiContext.close();
  deploy = 1;
}

// ---------------------------------------------------------------------------
// STEP 9: no socket at all. Nothing left to trust about the emulation.
console.log("\nWith the server socket closed outright");

markWitness("the closed-socket load");
await new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(resolve);
});

// index.html this time rather than "./", so both cached navigation keys are
// exercised - a user with a bookmarked bare URL and one with the filename in it
// are two different cache lookups.
await page.goto(`${origin}/index.html`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => document.body.dataset.activeView, null, { timeout: 30000 });

const noSocket = await page.evaluate(() => ({
  libraryVisible: !document.getElementById("view-library")?.classList.contains("hidden"),
  sidebarRendered: (document.getElementById("library-sidebar")?.children.length ?? 0) > 0,
  listHtml: document.getElementById("library-list")?.textContent || "",
}));

check("the Library renders with no listening socket to reach", noSocket.libraryVisible && noSocket.sidebarRendered);
check("the seeded document is still listed", noSocket.listHtml.includes("Offline canary note"));

const socketClosedConsole = takeConsoleErrors(page);
check("nothing logged a console error with the socket closed", socketClosedConsole.length === 0, socketClosedConsole.join(" | "));

// ---------------------------------------------------------------------------

await context.close();
await browser.close();

if (failures.length) {
  console.error(`\nFAILED: ${failures.length} check(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nAll offline checks passed: the app boots and scans with no network, the precache");
console.log("manifest matches the tree, the 6.7 MB recognition payload stays out of first load, and");
console.log("a plain http:// load still registers nothing at all.");
