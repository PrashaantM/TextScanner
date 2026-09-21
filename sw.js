// sw.js: the service worker that makes WEB-COMPLETION-PLAN.md §W1's offline
// claim true. Built for W1; read this header before changing any strategy
// below, because two of the three are load-bearing for reasons that are not
// obvious from the code.
//
// WHAT THIS BUYS. Before this file, opening the app with the network off gave
// the browser's own error page: every runtime asset was vendored (so no CDN was
// needed AT SCAN TIME) but the page itself still arrived over the network like
// any website. README.md was precise about that gap. Now a cold, offline load
// renders the Library and scans a local image end to end.
//
// ---------------------------------------------------------------------------
// THE TWO BUCKETS, AND WHY THE SPLIT IS NOT A MICRO-OPTIMISATION.
//
// vendor/tesseract is 11 MB on disk - 7.5 MB of wasm cores and a 2.9 MB
// language file. Precaching that wholesale at install time would mean every
// first visit pays 11 MB before the app is usable, including the visits that
// never scan anything. That is a hostile first load, and it would be a
// REGRESSION against today's behaviour, where those bytes are fetched on the
// first scan and not before.
//
// BUCKET 1 - THE APP SHELL, precached eagerly at install (SHELL_ASSETS below).
// Everything the app needs to BOOT and render its UI, and nothing else:
//
//   ./ and index.html      the navigation target, cached under both keys
//                          because a reload of the deployed URL requests "./"
//                          while the gates and a typed URL request index.html
//   style.css
//   js/*.js                all 50 modules - unbundled ES modules, so a missing
//                          one is a blank screen, not a degraded one
//   manifest.webmanifest    } W7's install metadata; an installed PWA that
//   icons/ (4 PNGs)         } cannot paint its own icon offline looks broken
//   vendor/tesseract/tesseract.min.js
//                          MUST be eager: index.html:879 loads it in a plain
//                          blocking <script>, so the page does not boot at all
//                          without it. 68 KB.
//   vendor/fonts/roboto-condensed/RobotoCondensed-Regular.ttf
//                          47 KB, and measured rather than assumed to matter:
//                          a request-logging run of a real scan shows the
//                          browser fetching it (dest=font) when
//                          js/editorObjects.js's detectCondensedSource decides
//                          a scan's source text reads as condensed. Offline
//                          that fetch has to come from somewhere or condensed
//                          words silently render in the fallback face.
//
// 1.07 MB as stored - index.html is counted twice, once under "./" and once
// under its filename - against the 11 MB the naive version would have cost.
//
// NOT in the shell, deliberately: 404.html (GitHub Pages serves it for unknown
// paths; offline, an unknown path falls back to the cached shell anyway, which
// is better) and the two .LICENSE.txt files (never requested at runtime).
//
// BUCKET 2 - THE RECOGNITION PAYLOAD, cached lazily on the first successful
// scan (VENDOR_LAZY below). Three files, 6.69 MB as actually stored:
//
//   vendor/tesseract/worker.min.js                          124 KB
//   vendor/tesseract/core/tesseract-core-<simd->lstm.wasm.js  3.76 MB
//   vendor/tesseract/tessdata/eng.traineddata.gz            2.82 MB
//
// "On the first successful scan" needs no message plumbing from the page,
// because the first scan is precisely what REQUESTS these three - the cache
// fills as a side effect of the requests the scan already makes. One core is
// stored, not both: the worker picks simd-vs-plain at runtime from its own SIMD
// detection (js/ocrEngine.js's corePath is a DIRECTORY and the worker appends
// the filename), and caching on demand stores exactly the one that engine
// asked for rather than guessing.
//
// THAT THIS WORKS AT ALL WAS MEASURED, NOT ASSUMED, and it is the single fact
// this design rests on. Two of those three files are fetched by the Tesseract
// WORKER, not by the page - and that worker is a blob: Worker
// (js/ocrEngine.js wraps workerPath in a Blob, which is why index.html's CSP
// carries worker-src blob:). Whether a service worker's fetch handler sees
// requests from a blob:-sourced dedicated worker is not something to guess at,
// and if it did not, lazy caching could never serve them back offline and this
// whole approach would have to change. A probe registered a recording service
// worker, ran a real scan, and asked it what it saw:
//
//   vendor/tesseract/worker.min.js                          mode=no-cors dest=script
//   vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js  mode=no-cors dest=script
//   vendor/tesseract/tessdata/eng.traineddata.gz            mode=cors    dest=
//
// All three intercepted, on chromium. test/offline.js then asserts the
// consequence - a real scan with the network genuinely off - rather than
// trusting this note.
//
// ---------------------------------------------------------------------------
// STALE-CACHE LOCKOUT IS THE WORST THING THIS FILE COULD DO, AND THE STRATEGY
// BELOW IS CHOSEN AROUND THAT RATHER THAN AROUND SPEED.
//
// A service worker that answers index.html from cache first ships an app that
// can never be updated again: every reload returns the pinned build, and the
// only cure is for the user to clear site data - which, for a local-first app
// whose documents live in IndexedDB, is the one thing you must never ask them
// to do. So:
//
//   NAVIGATIONS are NETWORK-FIRST. Online, you always get the build that is
//   actually deployed. The cache answers only when the network does not.
//
//   SHELL ASSETS are NETWORK-FIRST TOO, and that is the less obvious half.
//   This repo has no build step and therefore no content hashes in filenames
//   (WEB-COMPLETION-PLAN.md §0 calls the no-build-step property worth more
//   than the milliseconds, and §0's own numbers say 49 unbundled modules over
//   HTTP/2 is not a load problem). Cache-first on js/*.js would pin last
//   week's modules under a freshly fetched index.html - a version skew that
//   presents as an app broken in a way no single file explains. Network-first
//   means the cache is a genuine offline FALLBACK and never a source of skew.
//   The cost is that the worker makes the app no faster online; that is the
//   correct trade for this repo, which has already stated which side it is on.
//
//   THE RECOGNITION PAYLOAD is CACHE-FIRST, because those three files are
//   large, immutable in practice, and revalidating 6.7 MB on every scan is the
//   hostile behaviour this file exists to avoid. The coupling that buys: if
//   Tesseract is ever bumped and the new bytes land under the SAME filenames,
//   a cached client keeps the old core until SW_VERSION below is bumped. So
//   bumping tesseract.js means bumping SW_VERSION in the same commit. See
//   vendor/tesseract/README.md's "Before you bump the version" for the other
//   reasons that bump is not routine.
//
//   skipWaiting() + clients.claim() ON PURPOSE. The classic way a new build
//   never reaches a user is a new worker parked in "waiting" forever because
//   some tab is always open. Activating immediately is the anti-lockout
//   direction, and it is safe HERE specifically because the shell is
//   network-first: there is no cached-asset skew for an immediate swap to
//   expose.
//
//   ?nosw IS A REAL KILL SWITCH, not just a test hook - see
//   js/serviceWorkerRegistration.js. Loading the app with ?nosw unregisters
//   this worker and deletes its caches, so a lockout that somehow survives all
//   of the above has a recovery path that does not touch IndexedDB.
//
// ---------------------------------------------------------------------------
// THE WORKER SCRIPT ITSELF ARRIVES LATE, AND THAT IS PAGES, NOT THIS FILE.
// READ THIS BEFORE TRYING TO VERIFY A CHANGE TO sw.js ON THE LIVE SITE, because
// the obvious check - push, reload twice, look - is the one that does not work.
//
// GitHub Pages serves /sw.js with `cache-control: max-age=600`, exactly as it
// serves every other asset. WEB-COMPLETION-PLAN.md §0 records that header as an
// asset-loading fact about /js/main.js; it is not special-cased for workers, and
// the update check a navigation triggers goes through the HTTP cache like any
// other request. So for about ten minutes after a deploy, a plain reload keeps
// running the worker the browser already has. Re-checked 2026-09-20:
// `curl -I https://prashaantm.github.io/TextScanner/sw.js` -> cache-control: max-age=600.
//
// MEASURED AGAINST THE LIVE ORIGIN, not reasoned from the spec:
//
//   app CONTENT           updated on the FIRST reload. Network-first works.
//   the WORKER SCRIPT     OLD at t=0, OLD at t=2min, OLD at t=6min, NEW at t=11min
//   registration.update() bypasses the throttle and installs the new worker at once
//
// The probe that confirmed the fetch was reaching the origin rather than being
// answered from somewhere closer returned:
//
//   {"ok":true,"bytes":87501,"ms":8006}
//
// IT HAS ALREADY PRODUCED ONE FALSE NEGATIVE, which is why it is written here
// rather than left to be rediscovered. The first live redeploy check reported
// the OLD worker still in control after two reloads and read as a stale-cache
// lockout - the exact failure the strategy above is built against - and it was
// the throttle. The two are distinguishable, but only by the clock: a throttle
// clears on its own by about t=11min, and a lockout does not clear at all.
//
// WHAT FOLLOWS FOR ANYONE CHANGING THIS FILE. Two reloads immediately after a
// push prove nothing either way. A worker change that carries no visible
// discriminator - no SW_VERSION bump, no observable behaviour difference -
// cannot be checked behaviourally at all until the throttle expires; give it one
// before deploying if you intend to check it, or wait out the ten minutes.
//
// ---------------------------------------------------------------------------
// CSP: NO CHANGE NEEDED, CONFIRMED RATHER THAN ASSUMED. index.html:55 already
// carries worker-src 'self' blob: (which covers registering a same-origin
// worker script) and default-src 'self' (which covers the same-origin fetches
// below). Checked against the literal meta tag, because this app has shipped
// one bug through this CSP already: style-src 'self' silently refuses style
// ATTRIBUTES, which is how redaction boxes rendered 0x0 (ebb119d). Note that
// connect-src carries no data: - irrelevant here, since nothing in this file
// fetches a data: URI, but it is the other directive in this CSP that drops
// something without saying so.
//
// The registration itself CANNOT be an inline <script> in index.html for the
// same family of reason: script-src is 'self' 'wasm-unsafe-eval' with no
// 'unsafe-inline', so an inline registration block would be refused outright.
// It lives in js/serviceWorkerRegistration.js and is loaded as a module.

// Bumping this drops every cache below and refetches. Bump it when the
// recognition payload's bytes change under unchanged filenames (a tesseract.js
// upgrade); the shell does not need it, being network-first.
//
// DELIBERATELY NOT BUMPED FOR THE CACHE-FAILURE FIXES BELOW, and the reasoning
// is worth keeping because the instinct on any service-worker change is to bump.
// A worker updates when its own BYTES change, which these fixes do; SW_VERSION
// controls only cache NAMING and eviction. The already-cached bytes on live
// clients are not wrong - the defects were about writes failing, not about bad
// data being stored - so bumping would evict a 6.7 MB recognition payload from
// every client that has one and leave them unable to scan offline until their
// next online scan. That is a real cost for no correctness gain.
const SW_VERSION = "1";

// The tesseract.js version the cache-first recognition payload below was filled
// from, and the mechanism that makes the SW_VERSION coupling survive a bump by
// someone who has never read this file.
//
// THE COUPLING, and why a comment was not enough. The payload is cache-first, so
// if tesseract.js is bumped and the new bytes land under the SAME filenames, a
// client that already cached the old core keeps serving it forever - a silent
// pin to a stale engine. sw.js recorded that in prose and pointed AT
// vendor/tesseract/README.md's "Before you bump the version" section as the
// place it was written down. The pointer ran one way: that section never
// mentioned SW_VERSION, so the person doing the bump - who opens the vendor
// README, not this file - was never told.
//
// Prose in two places would drift, which is §0's whole standing lesson. So the
// version is declared here as DATA and test/repo-contract.js (CHECK 5) reads the
// real version out of vendor/tesseract/tesseract.min.js's own bytes and fails if
// the two disagree. A bump therefore cannot land without editing this file,
// which is the file SW_VERSION lives in. The reverse prose pointer is in the
// vendor README as well now, but the gate is what makes it durable.
const VENDORED_TESSERACT_VERSION = "5.1.1";

const SHELL_CACHE = `textscanner-shell-v${SW_VERSION}`;
const VENDOR_CACHE = `textscanner-vendor-v${SW_VERSION}`;
const OWNED_CACHES = new Set([SHELL_CACHE, VENDOR_CACHE]);

// Resolved against this worker's own location, never against the origin root:
// the deployment is served from /TextScanner/, not /, so an absolute "/js/x.js"
// here would 404 on the live site while working perfectly in every local test.
const BASE = new URL("./", self.location.href);
const at = (path) => new URL(path, BASE).href;

// THE PRECACHE MANIFEST. Explicit, and it has to be: a service worker cannot
// glob a directory, so this list is the one place in the repo that restates
// what js/ contains. That makes it exactly the thing that rots when a module is
// renamed - so test/offline.js asserts this list against `ls js/*.js` on disk,
// in both directions, and fails there rather than in a user's offline tab.
const SHELL_ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  // Blocking classic <script> at index.html:879 - the page cannot boot without it.
  "vendor/tesseract/tesseract.min.js",
  // Requested at scan time by the condensed-source path; 47 KB.
  "vendor/fonts/roboto-condensed/RobotoCondensed-Regular.ttf",
  "js/annotate.js",
  "js/app.js",
  "js/backup.js",
  "js/coherence.js",
  "js/coherenceClaude.js",
  "js/coherenceGate.js",
  "js/coherenceOnDevice.js",
  "js/coherenceRouter.js",
  "js/commandPalette.js",
  "js/cropView.js",
  "js/diagnostics.js",
  "js/documents.js",
  "js/dom.js",
  "js/edgeDetect.js",
  "js/editorExport.js",
  "js/editorInteractions.js",
  "js/editorObjects.js",
  "js/factCheck.js",
  "js/filter.js",
  "js/fontMatch.js",
  "js/haptics.js",
  "js/inkFit.js",
  "js/inpaint.js",
  "js/langDetect.js",
  "js/library.js",
  "js/main.js",
  "js/mlkitEngine.js",
  "js/notesEditor.js",
  "js/ocrEngine.js",
  "js/offlineRecognition.js",
  "js/pdf.js",
  "js/perspective.js",
  "js/piiDetect.js",
  "js/preprocess.js",
  "js/radialMenu.js",
  "js/recognize.js",
  "js/reducedTransparency.js",
  "js/scanDoc.js",
  "js/scanFilters.js",
  "js/serviceWorkerRegistration.js",
  "js/state.js",
  "js/store.js",
  "js/toast.js",
  "js/translate.js",
  "js/translateClaude.js",
  "js/translateHistory.js",
  "js/translateLanguages.js",
  "js/translateOnDevice.js",
  "js/tts.js",
  "js/views.js",
];

const SHELL_URLS = new Set(SHELL_ASSETS.map(at));

// The recognition payload, matched by prefix rather than listed, because the
// core filename is chosen by the worker's runtime SIMD detection and the point
// is to store whichever one it actually asked for. tesseract.min.js is excluded
// because it is in the shell (it loads before any scan).
const VENDOR_LAZY_PREFIXES = [
  at("vendor/tesseract/core/"),
  at("vendor/tesseract/tessdata/"),
];
const VENDOR_LAZY_EXACT = new Set([at("vendor/tesseract/worker.min.js")]);

const isLazyVendor = (url) =>
  VENDOR_LAZY_EXACT.has(url) || VENDOR_LAZY_PREFIXES.some((prefix) => url.startsWith(prefix));

// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // openCache rather than caches.open: if storage is refused outright there
      // is nothing to precache, but failing the install would just make every
      // navigation retry it. The worker activates and its fetch handler degrades
      // to pure passthrough - the same behaviour as having no worker at all.
      const cache = await openCache(SHELL_CACHE);
      // Added one at a time rather than with cache.addAll, which rejects the
      // WHOLE batch if any single request fails and would leave a first-time
      // visitor with no offline capability at all because one icon 404'd. A
      // missing shell asset is reported and the rest still cached; the gate is
      // what turns a missing asset into a red build.
      const failed = [];
      if (cache) {
        await Promise.all(
          SHELL_ASSETS.map(async (path) => {
            try {
              // cache: "reload" so a fresh install never seeds itself from the
              // HTTP cache's copy of a build that is already being replaced.
              const response = await fetch(new Request(at(path), { cache: "reload" }));
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              await cache.put(at(path), response);
            } catch (error) {
              failed.push(`${path}: ${error.message}`);
            }
          })
        );
      }
      if (failed.length) {
        console.error(`[sw] ${failed.length} shell asset(s) not precached:\n  ${failed.join("\n  ")}`);
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop anything this version does not own, so a SW_VERSION bump actually
      // reclaims the old 6.7 MB payload instead of accumulating a second copy.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !OWNED_CACHES.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

// Lets the page ask what is cached without reaching into the Cache API itself,
// and lets ?nosw order a full teardown before it unregisters. Both are small
// enough to keep here rather than in a second file.
self.addEventListener("message", (event) => {
  const reply = (data) => event.ports?.[0]?.postMessage(data);
  if (event.data === "sw:manifest") {
    reply({ version: SW_VERSION, shellCache: SHELL_CACHE, vendorCache: VENDOR_CACHE, shell: SHELL_ASSETS.map(at) });
    return;
  }
  if (event.data === "sw:purge") {
    event.waitUntil(
      (async () => {
        await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
        reply({ purged: true });
      })()
    );
  }
});

// Cache keys drop the query string. Reads already pass ignoreSearch, but writes
// need it too or every query variant of the same file becomes its own entry -
// index.html, index.html?sw=1 and index.html?nosw would be three copies of the
// same 60 KB, and the precache manifest check would be comparing against a set
// that grows with however the page happened to be opened.
function keyFor(request) {
  const url = new URL(request.url);
  url.search = "";
  return url.href;
}

// ---------------------------------------------------------------------------
// THE INVARIANT EVERY HELPER BELOW EXISTS TO HOLD: **a Cache API failure must
// never change what the page receives.** Caching is an optimisation for the
// NEXT load; the current load has already got its bytes. Two shipped defects
// came from breaking that invariant in two different directions, and both fire
// on the same trigger - a failing `cache.put`, which in an app that fills
// IndexedDB with scanned documents means a full disk, a real state rather than a
// theoretical one:
//
//   - In networkFirst the put sat INSIDE the try. A rejecting put fell into the
//     catch, which then served the STALE cached copy while the network was
//     perfectly healthy and had just returned a good response. That is the exact
//     version skew this file's header says the design exists to prevent.
//   - In cacheFirst the same put threw straight out of the function, so
//     respondWith rejected and the browser reported a network error for
//     eng.traineddata.gz. A full disk broke scanning outright even though the
//     file had downloaded fine.
//
// So every cache operation is wrapped. Reads degrade to "nothing cached", writes
// degrade to "not cached", and neither can propagate into the response path.
// test/offline.js stubs the Cache API so put always rejects and asserts the page
// still receives the FRESH network body from both strategies - that assertion,
// not these wrappers, is what keeps the invariant true.

async function openCache(name) {
  try {
    return await caches.open(name);
  } catch (error) {
    // Storage disabled entirely, or a partitioned context that refuses it.
    console.warn(`[sw] cache ${name} unavailable: ${error.message}`);
    return null;
  }
}

async function cachedMatch(cache, key) {
  if (!cache) return undefined;
  try {
    return await cache.match(key, { ignoreSearch: true });
  } catch (error) {
    console.warn(`[sw] cache read failed for ${key}: ${error.message}`);
    return undefined;
  }
}

async function putSafely(cache, key, response) {
  if (!cache) return;
  try {
    await cache.put(key, response);
  } catch (error) {
    // QuotaExceededError is the one that matters: the disk is full because the
    // user has scanned a lot. Nothing to do about it here, and nothing about the
    // response the page is already holding changes.
    console.warn(`[sw] could not cache ${key}: ${error.name} ${error.message}`);
  }
}

// How long a network-first request may hang before the cache answers instead.
//
// WHY A TIMEOUT EXISTS AT ALL. network-first with no timeout handles "offline"
// (fetch rejects, the catch runs) and mishandles LIE-FI: a captive portal or a
// hanging connection ACCEPTS the request and never answers, so fetch stays
// pending, never rejects, and the fallback never runs. Reproduced with a route
// handler that never resolves: hard-offline rendered the Library, while lie-fi
// hung for the full 15s of the probe's patience with a perfectly good cached
// copy sitting unused.
//
// WHY 8 SECONDS, measured rather than chosen by taste. A warm full-shell load
// through this worker is 56ms on loopback, three runs, and the slowest single
// shell resource in that load is 16ms - so 8s is ~140x the whole shell and ~500x
// any one asset. The largest eager asset is 93 KB (js/editorObjects.js) before
// gzip; on a slow 3G link (~50 KB/s) its gzipped form is well under a second, so
// 8s leaves better than an order of magnitude of headroom before a
// working-but-slow connection could lose the race.
//
// WHY IT CANNOT CAUSE A LOCKOUT, which is the risk that actually matters. The
// network is always tried FIRST and always wins if it answers at all within the
// window; the cache is never preferred. A cache entry is only ever written by a
// successful fetch of that same URL, so the worst thing a timeout can serve is
// "the last build you successfully loaded" - never something you never had, and
// never something that outlives the next successful load, because the next
// network-first hit overwrites it. There is no state this can reach where a new
// deploy stops arriving.
//
// WHAT IT CAN DO, stated rather than glossed: a connection marginal exactly at
// the boundary can time out on some assets and succeed on others, mixing two
// build generations within one load. That window is NOT created by the timeout -
// per-asset network-first already mixes generations on a flaky link where some
// fetches reject and others succeed - but the timeout does widen it slightly.
// The mixture self-heals on the next load over a working network.
const NETWORK_FIRST_TIMEOUT_MS = 8000;

// Deliberately NOT applied to cacheFirst. That path fetches the 6.7 MB
// recognition payload, which legitimately takes minutes on a slow link (3.8 MB
// at ~50 KB/s is over a minute for the core alone), and it has no cached
// fallback to race toward - that is precisely why it is fetching. A timeout
// there would convert slow-but-working downloads into failed scans, which is the
// opposite of the point.
async function fetchWithin(request, ms) {
  let timer;
  try {
    return await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[sw] network did not answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function networkFirst(request, cacheName, fallbacks = []) {
  const cache = await openCache(cacheName);

  let response;
  try {
    response = await fetchWithin(request, NETWORK_FIRST_TIMEOUT_MS);
  } catch {
    const hit = await cachedMatch(cache, request);
    if (hit) return hit;
    for (const fallback of fallbacks) {
      const alternative = await cachedMatch(cache, fallback);
      if (alternative) return alternative;
    }
    throw new Error(`[sw] offline and nothing cached for ${request.url}`);
  }

  // OUTSIDE the try, and that placement is the whole fix: a failing cache write
  // must not be mistaken for a failed network. Only a real 200 is worth storing
  // - an opaque or partial response cached here would be replayed offline as the
  // app's own asset.
  if (response.ok && response.type !== "opaque") {
    await putSafely(cache, keyFor(request), response.clone());
  }
  return response;
}

async function cacheFirst(request, cacheName) {
  const cache = await openCache(cacheName);
  const hit = await cachedMatch(cache, request);
  if (hit) return hit;
  // No timeout here on purpose - see fetchWithin's note.
  const response = await fetch(request);
  if (response.ok && response.type !== "opaque") {
    await putSafely(cache, keyFor(request), response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // GET only: a POST is never replayable from a cache, and this app makes no
  // same-origin ones anyway.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Cross-origin is left entirely alone. The one cross-origin request this app
  // makes is the opt-in Coherence Filter / translation call to
  // api.anthropic.com, and a cached answer to THAT would be both wrong and a
  // privacy surprise. Not intercepting it also means an offline app reports a
  // real network failure for it, which is the honest result.
  if (url.origin !== self.location.origin) return;

  // Outside this worker's own directory (the deployment lives at /TextScanner/,
  // and the scope is that directory) - not ours to answer.
  if (!request.url.startsWith(BASE.href)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, [at("./"), at("index.html")]));
    return;
  }

  // Both lookups below are made against the query-stripped URL. Nothing in this
  // app appends a cache-busting query today, but if anything ever did,
  // "style.css?v=2" would miss the shell set, fall through to the passthrough at
  // the bottom, and fail offline - a bug that would only ever show up with the
  // network already gone, which is the worst place to find one.
  const normalized = keyFor(request);

  if (isLazyVendor(normalized)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
    return;
  }

  if (SHELL_URLS.has(normalized)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Anything else same-origin and in scope - a scan fixture a gate feeds in, a
  // path added after this file was written - goes to the network untouched. A
  // service worker that tried to cache everything it saw would be caching the
  // test corpus.
});
